module.exports = function () {

    var db = require('../db');
    var Hosts = require('../db/schemas/dbHost');
    var unitConverter = require('../util/unitConverter')();
    var _ = require('underscore');
    var cloudstack = new (require('csclient'))({
        serverURL: CLOUDSTACK.API,
        apiKey: CLOUDSTACK.API_KEY,
        secretKey: CLOUDSTACK.SECRET_KEY
    });

    var response = require('../../config/responseMessages');

    var getValueByZabbixKey = function (host, key) {
        for (var i = 0; i < host.itemInfo.length; i++) {
            if (host.itemInfo[i].itemKey == key) {
                return host.itemInfo[i].value;
            }
        }
        return false;
    };

    var findMaxMemHost = function (hostsInfo, authorizedRequest) {

        var askingMemory = unitConverter.convertMemoryAndStorage(authorizedRequest.requestContent.group[0].min_memory[0].size[0],authorizedRequest.requestContent.group[0].min_memory[0].unit[0], 'b');

        var maxMemHostIndex = 0;
        var maxMemHost = _.clone(hostsInfo[maxMemHostIndex]);
        var maxMemory = getValueByZabbixKey(hostsInfo[maxMemHostIndex], 'vm.memory.size[available]');

        for (var i = 0; i < hostsInfo.length; i++) {
            var currentHostMemory = getValueByZabbixKey(hostsInfo[i], 'vm.memory.size[available]');
            if ((currentHostMemory > maxMemory) && (askingMemory < currentHostMemory)) {
                maxMemory = currentHostMemory;
                maxMemHostIndex = i;
                maxMemHost = _.clone(hostsInfo[i]);
            }
        }

        return hostsInfo.splice(maxMemHostIndex,1);

    };

    var findHostByMigration = function (index, authorizedRequest, allPossibleHosts, callback) {

        if(index >= allPossibleHosts.length){
            //if all hosts are checked and no suitable host found? return empty
            callback(null, null);
        }
        else{
            var candidate = findMaxMemHost(_.clone(allPossibleHosts), authorizedRequest);

            Hosts.find({ zabbixID: candidate.hostId }).exec(function (err, result) {
                if(err){
                    callback(response.error(500, "Database error!", err));
                }
                else{

                    var vmList = [];

                    cloudstack.execute('listVirtualMachines', { hostid: result.cloudstackID }, function(err, result){

                        if(err){
                            callback(response.error(500, 'Cloudstack Error!', err));
                        }
                        else{
                            var vmListResponse = result.listvirtualmachinesresponse.virtualmachine;

                            getVMSpecs(0, vmListResponse, vmList, function (err, vmList) {
                                Hosts.find({}).exec(function (err, hostArray) {
                                    if(err){
                                        callback(response.error(500, 'Database Error', err));
                                    }
                                    else{
                                        checkVMMigratability(vmList, hostArray, 0, allPossibleHosts, _.clone(allPossibleHosts));
                                    }
                                });
                            });
                        }
                    });

                    //callback(null, "This is the selected host by migration scheduler");
                }
            });
        }

    };


    var getVMSpecs = function (vmIndex, vmListResponse, vmList, callback) {
        if(vmIndex == vmListResponse.length){
            callback(null, vmList);
        }
        else{
            var vmID = vmListResponse[vmIndex].id;
            var vmHostID = vmListResponse[vmIndex].hostid;
            var serviceOfferingId= vmListResponse[vmIndex].serviceofferingid;

            cloudstack.execute('listServiceOfferings', {id: serviceOfferingId}, function (err, result) {
                if (err) {
                    callback(response.error(500, 'Cloudstack Error!', err));
                }
                else {
                    var serviceOffering = result.listserviceofferingsresponse.serviceoffering[0];

                    vmList[vmIndex] = {
                        vmID: vmID,
                        hostID: vmHostID,
                        detailedInfo: vmListResponse[vmIndex],
                        numOfCores: serviceOffering.cpunumber,
                        cpuFreq: serviceOffering.cpuspeed,
                        memory: serviceOffering.memory,
                        storageType: serviceOffering.storagetype,
                        offerHA: serviceOffering.offerha
                    };
                    vmIndex++;
                    getVMSpecs(vmIndex, vmListResponse, vmList, callback);
                }
            });
        }
    };


    //TODO: Needs testing
    var checkVMMigratability = function (vmList, hosts, hostIndex, currentUtilizationInfo, predictedUtilizationInfo) {
        //Setting up vmList array in to decreasing order of memory
        for(var i=0; i<vmList.length; i++){
            console.log(vmList[i].memory);
        }
       vmList.sort(function(a,b){return b.memory - a.memory});
        console.log("---------------");

        for(var i=0; i<vmList.length; i++){
            console.log(vmList[i].memory);
        }
    };

   /* var compareDescending =function (attribute1, attribute2) {
        if(attribute1.memory>attribute2.memory){
            return -1;
        }
        else if(attribute1.memory<attribute2.memory){
            return 1;
        }
        else if(attribute1.memory == attribute2.memory){
            return 0;
        }

    };*/

    return {
        findHostByMigration: findHostByMigration
    }
};
